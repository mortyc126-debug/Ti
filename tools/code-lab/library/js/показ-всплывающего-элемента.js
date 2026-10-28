const popover = document.createElement("div");
popover.setAttribute("popover", "");
document.body.append(popover);

popover.showPopover();
console.log(popover.matches(":popover-open"));
